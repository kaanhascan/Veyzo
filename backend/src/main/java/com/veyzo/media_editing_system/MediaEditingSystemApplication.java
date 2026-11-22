package com.veyzo.media_editing_system;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class MediaEditingSystemApplication {

	public static void main(String[] args) {
		SpringApplication.run(MediaEditingSystemApplication.class, args);
	}

}
